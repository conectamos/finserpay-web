const body = params.trigger.body;
const message = body && body.message;
const outbound = body && body.event === 'new_message_sent' && message && message.direction === 'outbound';
const confirmation = body && body.event === 'new_message_received' && message && message.direction === 'inbound'
  && typeof message.content === 'string' && /^CONFIRMO PR-[A-F0-9]{16}$/.test(message.content.trim());
if (!message || message.content_type !== 'text' || (!outbound && !confirmation)) {
  module.exports = { ok: true, ignored: true, forward: 'no', request_body: '' };
} else {
  const conversation = body.conversation || {};
  const conversationMetadata = conversation.metadata || {};
  const attribution = message.metadata && message.metadata.agent_attribution || {};
  const messageIdentity = {
    id: message.id, conversation_id: message.conversation_id, direction: message.direction,
    content_type: message.content_type, sender_identifier: message.sender_identifier,
    recipient_identifier: message.recipient_identifier, status: message.status, created_at: message.created_at
  };
  if (outbound) messageIdentity.metadata = { agent_attribution: { agent_id: attribution.agent_id } };
  const requestBody = {
    event: body.event, delivery_id: body.delivery_id, created_at: body.created_at,
    agent_id: body.agent_id, workspace_id: body.workspace_id,
    agent_channel_id: body.agent_channel_id, phone_number: body.phone_number,
    conversation: {
      id: conversation.id, organization_id: conversation.organization_id, text_agent_id: conversation.text_agent_id,
      channel_type: conversation.channel_type, channel_identifier: conversation.channel_identifier,
      metadata: { channel_id: conversationMetadata.channel_id, organization_id: conversationMetadata.organization_id,
        agent_channel_type: conversationMetadata.agent_channel_type }
    },
    message: messageIdentity
  };
  module.exports = { ok: true, ignored: false, forward: 'yes', request_body: JSON.stringify(requestBody) };
}
