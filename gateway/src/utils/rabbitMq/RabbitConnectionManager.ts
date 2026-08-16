/**
 * Owns the single RabbitMQ connection + channel (the amqplib 3-layer
 * model: Connection = one TCP socket, Channel = lightweight conversation
 * ON that socket where all real work happens, Queue = named inbox on the
 * broker).
 *
 * Lazily connected: connect() only opens the socket the first time it's
 * called, so the gateway can boot even when RabbitMQ isn't up yet — the
 * first publish() attempt establishes the connection then.
 *
 * On 'close' the connection/channel references are nulled so the next
 * connect() opens a fresh socket (otherwise the dead channel would be
 * reused forever and logging would silently stop). If a live connection
 * is replaced, the onReconnect hook notifies subscribers so they can
 * reset broker-session-scoped state (e.g. queueEnsured).
 */
import amqp from 'amqplib';
import type { ChannelModel, Channel } from 'amqplib';

export class RabbitMQConnectionManager {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private readonly amqpUrl: string;
  private hadConnected = false;

  /**
   * Optional hook fired when a FRESH connection is successfully made
   * AFTER a previous one was dropped. Consumers (e.g. RabbitMqPublisher)
   * use it to reset state that is only valid while the same connection —
   * or, more precisely, the same broker session — is alive.
   */
  constructor(
    amqpUrl: string = 'amqp://localhost:5672',
    private readonly onReconnect?: () => void,
  ) {
    this.amqpUrl = amqpUrl;
  }

  /*
  Connects to rabbitMQ server and creates a channel.
  */

  public async connect(): Promise<void> {
    // Already connected? Nothing to do. This is what makes the method
    // idempotent — calling it 100 times costs one real connection.
    if (this.connection && this.channel) {
      return;
    }
    try {
      // 1. Open the TCP socket to the broker.
      this.connection = await amqp.connect(this.amqpUrl);
      // 2. Open a channel on top of that socket.
      this.channel = await this.connection.createChannel();
      // 3. Wire up logging for socket-level problems. 'error' = fatal
      //    socket issue, 'close' = the broker dropped us.
      this.connection.on('error', (err) => {
        console.error('[RabbitConnectionManager] Connection error:', err);
      });

      this.connection.on('close', () => {
        console.warn('[RabbitConnectionManager] Connection closed.');
        // CRITICAL: drop the references so the NEXT connect() call opens
        // a brand-new socket. Without this, publish() would keep handing
        // out the dead channel forever and logging would silently stop.
        this.connection = null;
        this.channel = null;
      });

      // Was this a RECONNECT (there was a live connection before)? Then
      // notify subscribers so they can reset session-scoped state.
      if (this.hadConnected) {
        this.onReconnect?.();
      }
      this.hadConnected = true;

      console.log('[RabbitConnectionManager] Connected to RabbitMQ successfully.');
    } catch (error) {
      console.error('Failed to connect to RabbitMQ:', error);
      throw error; // let the caller decide what to do (publisher catches it)
    }
  }

  // Hand out the channel, but REFUSE if we never connected. The caller
  // must remember to call connect() first.
  public async getChannel(): Promise<Channel> {
    if (!this.channel) {
      console.error('[RabbitConnectionManager] Channel is not initialized. Call connect() first.');
      throw new Error('Channel is not initialized. Call connect() first.');
    }
    return this.channel;
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }
      console.log('[RabbitConnectionManager] Disconnected from RabbitMQ successfully.');
    } catch (error) {
      console.error('[RabbitConnectionManager] Error while disconnecting from RabbitMQ:', error);
      throw error;
    }
  }
}