/**
 * getServiceUrls — parses a comma-separated list of backend URLs from
 * the environment (e.g. `USER_SERVICE_URLS`) into an array of trimmed
 * strings. This array feeds a service's RoundRobinLoadBalancer, so one
 * logical service can run as multiple replicas (see docker-compose).
 */
export default function getServiceUrls(serviceUrlString: string): string[] {
  return serviceUrlString.split(",").map((url) => url.trim());
}