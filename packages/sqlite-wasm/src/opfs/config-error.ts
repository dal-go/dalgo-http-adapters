/** An `openDemoDb` option combination that could damage the stored dataset, or contradicts itself. */
export class DemoDbConfigError extends TypeError {
  public readonly code = "demodb_config" as const;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DemoDbConfigError";
  }
}
