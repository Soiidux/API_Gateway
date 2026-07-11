export default function generateApiResponse<T>(data: T, message: string, status: number): ApiResponse<T> {
  return {
    data,
    message,
    status,
    success: status < 400,
  };
}