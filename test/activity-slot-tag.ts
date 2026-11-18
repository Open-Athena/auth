// The metadata the Slack activity sink tags each message with: thrds' slot tag (`thrds_key`, `thrds_slot`) and the
// hash of what was sent (`thrds_hash`), which is also what `activity_posts.parts` records per message.
import { msgHash, tagSlot } from '@open-athena/thrds'

export const slotHash = (key: string, slot: string | null, text: string): string => msgHash(tagSlot({ text }, key, slot))

export const slotMeta = (key: string, slot: string | null, text: string) => ({
  event_type: 'thrds_slot',
  event_payload: { thrds_key: key, thrds_slot: slot ?? '', thrds_hash: slotHash(key, slot, text) },
})
