import type { Request, Response, NextFunction } from 'express';
/**
 * Error handling utilities for database operations
 */

export class DatabaseError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string = 'DATABASE_ERROR', statusCode: number = 500) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends DatabaseError {
  constructor(entity: string, id: string | number) {
    super(`${entity} with ID ${id} not found`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends DatabaseError {
  constructor(message: string) {
    super(`Validation error: ${message}`, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends DatabaseError {
  constructor(message: string) {
    super(`Conflict: ${message}`, 'CONFLICT', 409);
    this.name = 'ConflictError';
  }
}

/**
 * Extract the driver error code (e.g. SQLITE_CONSTRAINT_UNIQUE) from an unknown error
 */
function getErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * Emit a structured log entry so database failures can be diagnosed and monitored
 */
function logDatabaseError(error: unknown, entity?: string, id?: string | number): void {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'database_error',
      entity,
      id,
      code: getErrorCode(error) || undefined,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Handle database errors and convert SQLite-specific errors to appropriate types
 * @note Errors raised by the driver are plain `Error`/`SqliteError` instances, so the
 *       SQLite-specific checks must run for non-`DatabaseError` values. Domain errors
 *       that already carry a status code are re-thrown untouched.
 */
export function handleDatabaseError(error: unknown, entity?: string, id?: string | number): never {
  // Domain errors already carry the correct code/status - propagate them unchanged
  if (error instanceof DatabaseError) {
    throw error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = getErrorCode(error);

  logDatabaseError(error, entity, id);

  // SQLite constraint violation (UNIQUE, FOREIGN KEY, etc.)
  // better-sqlite3 reports extended codes such as SQLITE_CONSTRAINT_UNIQUE
  if (code.startsWith('SQLITE_CONSTRAINT') || message.includes('constraint failed')) {
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || message.includes('UNIQUE constraint failed')) {
      throw new ConflictError('Resource already exists');
    }
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || message.includes('FOREIGN KEY constraint failed')) {
      throw new ValidationError('Invalid reference to related entity');
    }
    throw new ValidationError(message);
  }

  // SQLite busy/locked database
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
    throw new DatabaseError('Database is temporarily unavailable', 'DATABASE_BUSY', 503);
  }

  // Handle case where no rows were affected (for updates/deletes)
  if (message.includes('No rows affected') && entity && id !== undefined) {
    throw new NotFoundError(entity, id);
  }

  // Default to generic database error
  throw new DatabaseError(`Database operation failed: ${message}`, 'DATABASE_ERROR', 500);
}

/**
 * Express error handler middleware for database errors
 */
export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof DatabaseError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  // Default error handling
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
