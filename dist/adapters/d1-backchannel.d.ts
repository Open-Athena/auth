import { type BackchannelStore } from '../backchannel/store.js';
/** Each accept uses one transaction; guard failures must never mutate the target SID. */
export declare function d1BackchannelStore(db: D1Database): BackchannelStore;
