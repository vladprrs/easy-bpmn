// Product-facing runtime errors. Each maps to an HTTP status and a stable
// `{ error, details? }` body (see src/index.ts error mapping).

import type { ValidationIssueData } from "../bpmn/graph";

export class AppError extends Error {
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, message, details);
    this.name = "BadRequestError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", details?: Record<string, unknown>) {
    super(404, message, details);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, message, details);
    this.name = "ConflictError";
  }
}

/** Missing / malformed / unknown / revoked worker credential (HTTP 401). */
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", details?: Record<string, unknown>) {
    super(401, message, details);
    this.name = "UnauthorizedError";
  }
}

/** Authenticated but not permitted for this workspace/resource (HTTP 403). */
export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", details?: Record<string, unknown>) {
    super(403, message, details);
    this.name = "ForbiddenError";
  }
}

/** Publish-time rejection carrying element-level validation issues (HTTP 409). */
export class PublishRejectedError extends AppError {
  readonly validationIssues: ValidationIssueData[];

  constructor(message: string, validationIssues: ValidationIssueData[]) {
    super(409, message, { validationIssues });
    this.name = "PublishRejectedError";
    this.validationIssues = validationIssues;
  }
}
