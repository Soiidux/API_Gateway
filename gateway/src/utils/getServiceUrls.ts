export default function getServiceUrls(serviceUrlString: string): string[] {
  return serviceUrlString.split(",").map((url) => url.trim());
}