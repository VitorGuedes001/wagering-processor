#Requires -Version 5.1
<#
  Prepara e valida o ambiente do desafio de ponta a ponta.
  Roda na raiz do projeto:  .\bootstrap.ps1
#>

$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false
$step = 0

function Step([string]$name) {
    $script:step++
    Write-Host ""
    Write-Host "[$script:step] $name" -ForegroundColor Cyan
}

function Fail([string]$message, [string]$hint) {
    Write-Host ""
    Write-Host "FALHOU: $message" -ForegroundColor Red
    if ($hint) { Write-Host "  -> $hint" -ForegroundColor Yellow }
    exit 1
}

# ---------------------------------------------------------------- pré-requisitos
Step "Pré-requisitos"

foreach ($tool in @('bun', 'docker')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail "'$tool' não encontrado no PATH." $(
            if ($tool -eq 'bun') { 'Instale com: powershell -c "irm bun.sh/install.ps1 | iex"' }
            else { 'Instale o Docker Desktop e deixe-o rodando.' }
        )
    }
}

$ErrorActionPreference = 'Continue'
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker não está respondendo." "Abra o Docker Desktop e espere ficar pronto." }
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

Write-Host "  bun    $(bun --version)"
Write-Host "  docker ok"

# ---------------------------------------------------------------- dependências
Step "Instalando dependências"

bun add `
    '@nestjs/common' '@nestjs/core' '@nestjs/platform-express' `
    reflect-metadata rxjs
if ($LASTEXITCODE -ne 0) { Fail "bun add (nest) falhou." "" }

bun add `
    '@mikro-orm/core' '@mikro-orm/postgresql' '@mikro-orm/migrations' '@mikro-orm/nestjs' '@mikro-orm/decorators'
if ($LASTEXITCODE -ne 0) { Fail "bun add (mikro-orm) falhou." "" }

bun add '@aws-sdk/client-sqs' decimal.js
if ($LASTEXITCODE -ne 0) { Fail "bun add (aws/decimal) falhou." "" }

bun add -d '@mikro-orm/cli' typescript bun-types
if ($LASTEXITCODE -ne 0) { Fail "bun add -d falhou." "" }

# ---------------------------------------------------------------- infra
Step "Subindo Postgres e LocalStack"

docker compose up -d
if ($LASTEXITCODE -ne 0) { Fail "docker compose up falhou." "Veja: docker compose logs" }

Write-Host "  aguardando Postgres..." -NoNewline
$ok = $false
foreach ($i in 1..40) {
    $state = (docker inspect -f '{{.State.Health.Status}}' wagering-postgres 2>$null)
    if ($state -eq 'healthy') { $ok = $true; break }
    Start-Sleep -Seconds 2
    Write-Host "." -NoNewline
}
Write-Host ""
if (-not $ok) { Fail "Postgres não ficou healthy." "docker compose logs postgres" }

Write-Host "  aguardando filas no LocalStack..." -NoNewline
$ok = $false
foreach ($i in 1..40) {
    $queues = (docker exec wagering-localstack awslocal sqs list-queues 2>$null) -join ''
    if ($queues -match 'wager-transactions\.fifo') { $ok = $true; break }
    Start-Sleep -Seconds 2
    Write-Host "." -NoNewline
}
Write-Host ""
if (-not $ok) {
    Fail "As filas não foram criadas." `
         "Rode: docker compose logs localstack. Causa comum no Windows: o init-queues.sh salvo com quebra de linha CRLF."
}

# ---------------------------------------------------------------- migrations
Step "Migrations (up, down, up)"

bun run db:migrate
if ($LASTEXITCODE -ne 0) {
    Write-Host "  CLI do MikroORM falhou sob Bun — tentando com Node." -ForegroundColor Yellow
    npx mikro-orm migration:up
    if ($LASTEXITCODE -ne 0) { Fail "migration:up falhou nos dois runtimes." "Confira DB_HOST/DB_PORT e docker compose logs postgres" }
    Write-Host "  ANOTE no ARCHITECTURE.md: CLI roda em Node, aplicação roda em Bun." -ForegroundColor Yellow
}

bun run db:rollback  | Out-Null
bun run db:migrate   | Out-Null

# ---------------------------------------------------------------- smoke
Step "Smoke test"

bun run smoke
if ($LASTEXITCODE -ne 0) { Fail "Smoke test falhou." "A saída acima diz qual verificação quebrou." }

# ---------------------------------------------------------------- app
Step "Subindo a aplicação e checando /health"

$app = Start-Process -FilePath 'bun' -ArgumentList 'run', 'src/main.ts' -PassThru -NoNewWindow
try {
    $ready = $null
    foreach ($i in 1..20) {
        Start-Sleep -Seconds 1
        try { $ready = Invoke-RestMethod 'http://localhost:3000/health/ready' -TimeoutSec 3; break } catch { }
    }

    if (-not $ready) { Fail "A aplicação não respondeu em /health/ready." "Rode 'bun run start:dev' e veja o erro de boot." }

    Write-Host "  live:  $((Invoke-RestMethod 'http://localhost:3000/health/live').status)"
    Write-Host "  ready: $($ready.status)  postgres=$($ready.dependencies.postgres)  sqs=$($ready.dependencies.sqs)"

    if (-not ($ready.dependencies.postgres -and $ready.dependencies.sqs)) {
        Fail "Readiness não alcançou as duas dependências." "Checar SQS_ENDPOINT e DB_HOST."
    }
}
finally {
    if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force }
}

Write-Host ""
Write-Host "Ambiente pronto. Stack fechada." -ForegroundColor Green
Write-Host "Infra continua de pé. Para derrubar: bun run infra:down"
