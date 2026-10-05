import { clearAllMessages } from './conversation';

const CUSTOMER_DATA_OWNER_KEY = 'smart-assistant-data-owner';
const CUSTOMER_DATA_KEYS = [
  'smart-assistant-profile',
  'smart-assistant-privacy-enabled',
  'smart-assistant-memories',
  'smart-assistant-location-sharing',
  'smart-assistant-voice-id',
  'smart-z-installation-id',
];

export async function prepareCustomerLocalData(userId) {
  if (typeof window === 'undefined' || !userId) {
    throw new Error('Customer data can only be prepared for an authenticated browser user.');
  }

  if (window.localStorage.getItem(CUSTOMER_DATA_OWNER_KEY) === userId) return false;

  await clearAllMessages();
  for (const key of CUSTOMER_DATA_KEYS) {
    window.localStorage.removeItem(key);
  }
  window.localStorage.setItem(CUSTOMER_DATA_OWNER_KEY, userId);
  return true;
}
