/** Thrown by a store whose tables don't exist (the migration isn't applied). */
export class SessionLogNotSetUp extends Error {
    constructor() {
        super('session log is not set up on this deployment (no session_log table)');
        this.name = 'SessionLogNotSetUp';
    }
}
