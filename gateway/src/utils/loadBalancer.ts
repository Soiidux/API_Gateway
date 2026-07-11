export default class RoundRobinLoadBalancer {
  private index = 0;
  private servers: string[] = [];
  constructor(servers: string[]) {
    this.servers = servers;
  }

  getNextServer(): string{
    const server = this.servers[this.index];
    this.index = (this.index + 1) % this.servers.length;
    return server as string;
  }
}