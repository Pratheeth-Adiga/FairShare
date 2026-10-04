import { WebPlugin } from '@capacitor/core';
import type { KeepAlivePlugin } from './keepAlive';

export class KeepAliveWeb extends WebPlugin implements KeepAlivePlugin {
  private active = false;

  async start() {
    this.active = true;
    return { started: true };
  }

  async stop() {
    this.active = false;
    return { stopped: true };
  }

  async isActive() {
    return { active: this.active };
  }
}
