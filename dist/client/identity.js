export const DEFAULT_WHOAMI_ENDPOINT = '/api/auth/whoami';
const ADJECTIVES = [
    'Amber', 'Bold', 'Brisk', 'Calm', 'Clever', 'Coral', 'Cosmic', 'Curious', 'Dapper', 'Eager', 'Fabled', 'Gentle',
    'Glad', 'Golden', 'Hardy', 'Hidden', 'Humble', 'Indigo', 'Jade', 'Jolly', 'Keen', 'Kind', 'Lively', 'Lucky',
    'Lunar', 'Mellow', 'Merry', 'Mighty', 'Misty', 'Modest', 'Noble', 'Nimble', 'Olive', 'Patient', 'Plucky', 'Polar',
    'Quiet', 'Quick', 'Rapid', 'Rosy', 'Ruby', 'Rustic', 'Sage', 'Scarlet', 'Silver', 'Sleepy', 'Snowy', 'Solar',
    'Spry', 'Steady', 'Stormy', 'Sunny', 'Swift', 'Teal', 'Tidy', 'Topaz', 'Velvet', 'Vivid', 'Wandering', 'Warm',
    'Wise', 'Witty', 'Woolly', 'Zesty',
];
const ANIMALS = [
    'Albatross', 'Alpaca', 'Armadillo', 'Axolotl', 'Badger', 'Beaver', 'Bison', 'Capybara', 'Caribou', 'Cheetah',
    'Chinchilla', 'Coyote', 'Crane', 'Dingo', 'Dolphin', 'Dormouse', 'Egret', 'Falcon', 'Ferret', 'Finch', 'Fox',
    'Gazelle', 'Gecko', 'Gibbon', 'Heron', 'Hedgehog', 'Ibex', 'Ibis', 'Jackal', 'Jaguar', 'Kestrel', 'Koala', 'Lemur',
    'Lynx', 'Marmot', 'Meerkat', 'Mongoose', 'Moose', 'Narwhal', 'Ocelot', 'Otter', 'Panda', 'Pangolin', 'Pelican',
    'Penguin', 'Puffin', 'Quail', 'Quokka', 'Raccoon', 'Raven', 'Salamander', 'Seal', 'Sparrow', 'Stoat', 'Tapir',
    'Tortoise', 'Toucan', 'Vole', 'Walrus', 'Weasel', 'Wombat', 'Wren', 'Yak', 'Zebra',
];
/**
 * A stable "Anonymous Capybara"-style name for an anonymous link, derived from
 * its grant id: every session of one link gets the same name, and nothing is stored.
 */
export function pseudonym(grantId) {
    // FNV-1a, 32-bit: deterministic and synchronous, so a render can call it.
    let h = 0x811c9dc5;
    for (let i = 0; i < grantId.length; i++)
        h = Math.imul(h ^ grantId.charCodeAt(i), 0x01000193) >>> 0;
    return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >>> 6) % ANIMALS.length]}`;
}
/**
 * Best available human label: the *person*, then an email, or null for an
 * anonymous link (unnamed, or `anon`; see `pseudonym` for the latter). A link's
 * memo is not a candidate: it's the minter's note, and a gate doesn't send it to the link session.
 */
export function displayName(whoami) {
    if (!whoami)
        return null;
    if (whoami.kind === 'grant') {
        if (whoami.anon)
            return null;
        const subject = whoami.subject ?? {};
        return subject.name || subject.email || whoami.email || null;
    }
    // A self-set name wins over the bare email: it's who the person said they are.
    return whoami.subject?.name || whoami.email || null;
}
export function hasScope(whoami, scope) {
    if (!whoami)
        return false;
    return whoami.scopes.includes('*') || whoami.scopes.includes(scope);
}
