import { NextResponse } from 'next/server';
import { generateAssistantReply, AssistantResponseError } from '../../../../../lib/assistant-response';
import { getConfiguredClusterNodes } from '../../../../../lib/whatsapp-cluster';

export const runtime = 'edge';

function verifyClusterAuthentication(request, nodeId) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || request.headers.get('x-api-key') || '';

  if (!token) return false;

  const configuredNodes = getConfiguredClusterNodes();
  if (nodeId) {
    const matchedNode = configuredNodes.find((n) => n.id === Number(nodeId));
    if (matchedNode && matchedNode.key && matchedNode.key === token) {
      return true;
    }
  }

  // Fallback: check if the token matches any configured cluster node key
  return configuredNodes.some((n) => n.key && n.key === token);
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'INVALID_JSON_PAYLOAD' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const { nodeId, remoteJid, text, senderName, messageId } = body || {};

  // 1. Authenticate that the request comes from an authorized cluster node
  if (!verifyClusterAuthentication(request, nodeId)) {
    return NextResponse.json(
      { success: false, error: 'UNAUTHORIZED_CLUSTER_NODE' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 2. Validate message payload
  if (!text || typeof text !== 'string' || !text.trim()) {
    return NextResponse.json(
      { success: false, error: 'EMPTY_TEXT_MESSAGE' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 3. Generate AI Assistant Reply via Groq without storing chat logs
  try {
    const promptText = text.trim();
    const reply = await generateAssistantReply(promptText);

    return NextResponse.json(
      {
        success: true,
        reply,
        nodeId: nodeId || null,
        messageId: messageId || null,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[WhatsApp Cluster Message Pipeline] Error generating reply:', error);
    const errorCode = error instanceof AssistantResponseError ? error.code : 'ASSISTANT_UNAVAILABLE';

    return NextResponse.json(
      {
        success: false,
        error: errorCode,
        message: 'تعذر معالجة الرد الذكي في الوقت الحالي.',
      },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

