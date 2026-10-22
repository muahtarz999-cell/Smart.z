'use client';

/**
 * One entry point for every action the assistant returns, and the list of
 * capabilities the app tells the assistant about with each request.
 */
import { readComputerRoot } from './computer-tasks-client';
import { queueComputerTask } from './computer-task-flow';
import { executeDeviceAction, phoneActionsAvailable } from './device-actions';
import { isScreenControlEnabled, phoneControlAvailable, startPhoneAgent } from './phone-agent';
import { queueSend } from './send-actions';
import { currentCoords, deviceTimeZone } from './location';

export async function getAssistantCapabilities() {
  const timeZone = deviceTimeZone();
  const coords = await currentCoords();
  return {
    coords,
    phoneActions: phoneActionsAvailable(),
    phoneControl: phoneControlAvailable(),
    phoneControlEnabled: await isScreenControlEnabled(),
    computerRoot: readComputerRoot(),
    timeZone,
  };
}

/**
 * handlers: { getAccessToken, onMessage(text) for anything the user must see, onAgentProgress(event) }.
 */
export async function dispatchAssistantAction(action, handlers = {}) {
  if (!action || typeof action !== 'object') return;
  const notify = (text) => { if (text) handlers.onMessage?.(text); };
  try {
    switch (action.type) {
      case 'whatsapp_send':
        queueSend(action);
        return;
      case 'computer_task':
        queueComputerTask(action);
        return;
      case 'device_action':
        notify(await executeDeviceAction(action));
        return;
      case 'phone_agent':
        notify(await startPhoneAgent(action, { getAccessToken: handlers.getAccessToken, onProgress: handlers.onAgentProgress }));
        return;
      default:
    }
  } catch (error) {
    notify(error?.message || 'تعذر تنفيذ الإجراء على الجهاز.');
  }
}
