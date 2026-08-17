/**
 * generateApiResponse — tiny helper producing the standardized response
 * envelope used by the gateway's own middleware (auth, rate limit, cache,
 * body validation, proxy errors) and by the backend services.
 *
 * Every response across the system is shaped as:
 *
 *   { data, message, status, success }
 *
 * where `success` is derived from the HTTP status (< 400 => true).
 * The `ApiResponse<T>` interface lives in `types/types.d.ts` and is
 * declared globally so no imports are needed anywhere.
 */
export default function generateApiResponse<T>(data: T, message: string, status: number): ApiResponse<T> {
  return {
    data,
    message,
    status,
    success: status < 400,
  };
}