import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ConflictError,
    DatabaseError,
    NotFoundError,
    ValidationError,
    handleDatabaseError,
} from './errors';

/**
 * Build an error that mimics a better-sqlite3 `SqliteError`
 */
function sqliteError(code: string, message: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.name = 'SqliteError';
    error.code = code;
    return error;
}

describe('handleDatabaseError', () => {
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('maps a UNIQUE constraint violation to a 409 ConflictError', () => {
        const error = sqliteError('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: suppliers.email');

        try {
            handleDatabaseError(error);
            expect.unreachable('handleDatabaseError should throw');
        } catch (thrown) {
            expect(thrown).toBeInstanceOf(ConflictError);
            expect((thrown as ConflictError).statusCode).toBe(409);
            expect((thrown as ConflictError).code).toBe('CONFLICT');
        }
    });

    it('maps a FOREIGN KEY constraint violation to a 400 ValidationError', () => {
        const error = sqliteError('SQLITE_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed');

        try {
            handleDatabaseError(error);
            expect.unreachable('handleDatabaseError should throw');
        } catch (thrown) {
            expect(thrown).toBeInstanceOf(ValidationError);
            expect((thrown as ValidationError).statusCode).toBe(400);
        }
    });

    it('maps other constraint violations to a 400 ValidationError', () => {
        const error = sqliteError('SQLITE_CONSTRAINT_NOTNULL', 'NOT NULL constraint failed: suppliers.name');

        try {
            handleDatabaseError(error);
            expect.unreachable('handleDatabaseError should throw');
        } catch (thrown) {
            expect(thrown).toBeInstanceOf(ValidationError);
            expect((thrown as ValidationError).statusCode).toBe(400);
        }
    });

    it('maps a busy database to a 503 DatabaseError', () => {
        const error = sqliteError('SQLITE_BUSY', 'database is locked');

        try {
            handleDatabaseError(error);
            expect.unreachable('handleDatabaseError should throw');
        } catch (thrown) {
            expect(thrown).toBeInstanceOf(DatabaseError);
            expect((thrown as DatabaseError).code).toBe('DATABASE_BUSY');
            expect((thrown as DatabaseError).statusCode).toBe(503);
        }
    });

    it('maps "No rows affected" to a 404 NotFoundError when entity and id are known', () => {
        try {
            handleDatabaseError(new Error('No rows affected'), 'Supplier', 0);
            expect.unreachable('handleDatabaseError should throw');
        } catch (thrown) {
            expect(thrown).toBeInstanceOf(NotFoundError);
            expect((thrown as NotFoundError).statusCode).toBe(404);
        }
    });

    it('re-throws existing domain errors unchanged', () => {
        const notFound = new NotFoundError('Supplier', 999);

        expect(() => handleDatabaseError(notFound, 'Supplier', 999)).toThrow(notFound);
    });

    it('falls back to a generic 500 DatabaseError for unknown failures', () => {
        try {
            handleDatabaseError(new Error('disk I/O error'));
            expect.unreachable('handleDatabaseError should throw');
        } catch (thrown) {
            expect(thrown).toBeInstanceOf(DatabaseError);
            expect((thrown as DatabaseError).code).toBe('DATABASE_ERROR');
            expect((thrown as DatabaseError).statusCode).toBe(500);
            expect((thrown as DatabaseError).message).toContain('disk I/O error');
        }
    });

    it('logs structured diagnostic context for database failures', () => {
        expect(() => handleDatabaseError(sqliteError('SQLITE_BUSY', 'database is locked'), 'Supplier', 1)).toThrow();

        expect(console.error).toHaveBeenCalledTimes(1);
        const logged = JSON.parse((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
        expect(logged).toMatchObject({
            event: 'database_error',
            entity: 'Supplier',
            id: 1,
            code: 'SQLITE_BUSY',
            message: 'database is locked',
        });
    });
});
