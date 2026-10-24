/** SecretBox 单例，密钥来自环境变量或 data/master.key */
import { SecretBox } from './secretbox.ts';
import { loadConfig } from '../config.ts';

let box: SecretBox | null = null;

export function secretBox(): SecretBox {
  if (!box) box = new SecretBox(loadConfig().masterKey);
  return box;
}

/** 测试用 */
export function resetSecretBox(): void {
  box = null;
}
