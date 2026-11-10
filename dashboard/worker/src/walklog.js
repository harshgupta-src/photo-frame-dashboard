// Retired. The walk log used to live in this Durable Object; walks are now kept in Lifelog
// (walkstore.js). The empty class stays so the WALKS binding and its stored data remain until a
// `deleted_classes` migration removes them (see wrangler.jsonc).
import { DurableObject } from 'cloudflare:workers';

export class WalkLog extends DurableObject {}
