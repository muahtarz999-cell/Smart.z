import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

const root = process.env.WHATSAPP_SESSION_DIR || '/var/lib/smartz-whatsapp';
const encryptionKey = process.env.SESSION_ENCRYPTION_KEY;
if (!encryptionKey || Buffer.byteLength(encryptionKey) < 32) {
  throw new Error('SESSION_ENCRYPTION_KEY must be configured with at least 32 bytes.');
}
const key = createHash('sha256').update(encryptionKey).digest();

export function storageKeyForUser(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

export async function destroyStoredAuthState(userId) {
  await rm(userDir(userId), { recursive: true, force: true });
}

function userDir(userId) {
  return join(root, storageKeyForUser(userId));
}

function encrypt(data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}

function decrypt(envelope) {
  const parsed = JSON.parse(envelope);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()]);
}

export async function loadAuthState(userId) {
  const directory = userDir(userId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let saved;
  try {
    const contents = await readFile(join(directory, 'auth.enc'), 'utf8');
    saved = JSON.parse(decrypt(contents).toString('utf8'), BufferJSON.reviver);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const creds = saved?.creds || initAuthCreds();
  let connectionId = saved?.connectionId || null;
  const keys = new Map(Object.entries(saved?.keys || {}));
  let writeChain = Promise.resolve();
  const save = () => {
    writeChain = writeChain.then(async () => {
      const serialized = JSON.stringify({ userId, connectionId, creds, keys: Object.fromEntries(keys) }, BufferJSON.replacer);
      const temporaryPath = join(directory, `auth.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(temporaryPath, encrypt(serialized), { mode: 0o600 });
      await rename(temporaryPath, join(directory, 'auth.enc'));
    });
    return writeChain;
  };

  return {
    creds,
    get connectionId() { return connectionId; },
    async setConnectionId(id) {
      connectionId = id;
      await save();
    },
    saveCreds: save,
    keys: {
      async get(type, ids) {
        const values = {};
        for (const id of ids) {
          let value = keys.get(`${type}:${id}`);
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          if (value) values[id] = value;
        }
        return values;
      },
      async set(data) {
        for (const [type, values] of Object.entries(data)) {
          for (const [id, value] of Object.entries(values)) {
            const storageKey = `${type}:${id}`;
            if (value) keys.set(storageKey, value);
            else keys.delete(storageKey);
          }
        }
        await save();
      },
    },
    async destroy() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function listStoredUserIds() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(root, { withFileTypes: true });
  const userIds = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    try {
      const contents = await readFile(join(root, entry.name, 'auth.enc'), 'utf8');
      const saved = JSON.parse(decrypt(contents).toString('utf8'), BufferJSON.reviver);
      if (typeof saved.userId === 'string' && storageKeyForUser(saved.userId) === entry.name) userIds.push(saved.userId);
    } catch {
      // An unreadable or invalid session is not restored.
    }
  }
  return userIds;
}