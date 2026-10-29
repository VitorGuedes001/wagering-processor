export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
}

export interface HttpResponse {
  status(code: number): this;
  json(body: unknown): this;
  setHeader(name: string, value: string): this;
}
