/**
 * "Sign in with OA", framework-free: the markup and styles `<OaSignInButton>` (`/react`) renders, for a page built as
 * an HTML string (a Worker's own sign-in page). Both draw from here, so they look the same.
 */
/** The Open Athena mark's paths (the logo's rings and stems, from "Open Athena Logo Color.svg"), in its viewBox. */
export const OA_MARK = {
    viewBox: '1950 0 1430 1383',
    rings: [
        'M3098.84 76.02C3037.77 76.02 2988.22 125.57 2988.22 186.64C2988.22 247.72 3037.77 297.27 3098.84 297.27C3159.92 297.27 3209.46 247.72 3209.46 186.64C3209.46 125.57 3159.92 76.02 3098.84 76.02ZM2912.2 186.64C2912.2 83.57 2995.77 0 3098.84 0C3201.92 0 3285.49 83.57 3285.49 186.64C3285.49 289.72 3201.92 373.29 3098.84 373.29C2995.77 373.29 2912.2 289.72 2912.2 186.64Z',
        'M3191.49 653.98C3130.41 653.98 3080.87 703.52 3080.87 764.6C3080.87 825.68 3130.41 875.22 3191.49 875.22C3252.57 875.22 3302.11 825.68 3302.11 764.6C3302.11 703.52 3252.57 653.98 3191.49 653.98ZM3004.85 764.6C3004.85 661.52 3088.41 577.95 3191.49 577.95C3294.57 577.95 3378.14 661.52 3378.14 764.6C3378.14 867.68 3294.57 951.24 3191.49 951.24C3088.41 951.24 3004.85 867.68 3004.85 764.6Z',
        'M2149.71 381.03C2088.64 381.03 2039.09 430.57 2039.09 491.65C2039.09 552.72 2088.64 602.27 2149.71 602.27C2210.79 602.27 2260.34 552.72 2260.34 491.65C2260.34 430.57 2210.79 381.03 2149.71 381.03ZM1963.07 491.65C1963.07 388.57 2046.64 305 2149.71 305C2252.79 305 2336.36 388.57 2336.36 491.65C2336.36 594.72 2252.79 678.29 2149.71 678.29C2046.64 678.29 1963.07 594.77 1963.07 491.65Z',
    ],
    stems: [
        'M2536.08 609.09C2536.08 494.96 2452.22 400.39 2342.75 383.67C2324.83 351.71 2299.21 324.66 2268.41 305.05H2308.01C2475.91 305.05 2612.05 441.19 2612.05 609.09V1141.92C2612.05 1271.86 2506.71 1377.2 2376.77 1377.2V1301.18C2464.71 1301.18 2536.03 1229.86 2536.03 1141.92V609.09H2536.08Z',
        'M3009.56 578C2918.73 578 2837.23 617.79 2781.54 680.94V304.04C2781.54 221.24 2825.7 148.73 2891.73 108.8C2908.35 64.63 2938.63 27.2 2977.5 1.68C2824.69 17.73 2705.56 146.95 2705.56 304.04V1141.92C2705.56 1271.86 2810.9 1377.2 2940.84 1377.2V1301.18C2852.9 1301.18 2781.59 1229.86 2781.59 1141.92V882.05C2781.59 759.36 2878.42 659.36 2999.8 654.22C3017.63 623.32 3042.71 597.13 3072.75 578H3009.56Z',
    ],
};
/** The button's class list. */
export function oaSignInClasses(variant, account, className) {
    return ['oa-signin', `oa-signin-${variant}`, account ? 'oa-signin-account' : null, className].filter(Boolean).join(' ');
}
/** "Continue as <first name>", by the account's first name, else its address. */
export function firstName(account) {
    return account.name?.trim().split(/\s+/)[0] || null;
}
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => s.replace(/[&<>"']/g, c => ESC[c]);
/** The OA mark as an SVG string (`<OaMark>` in React). */
export function oaMarkSvg(size = 22) {
    const paths = (ds, rule = '') => ds.map(d => `<path${rule} d="${d}"/>`).join('');
    return `<svg class="oa-signin-mark" width="${size}" height="${size}" viewBox="${OA_MARK.viewBox}" aria-hidden="true" focusable="false">`
        + `<g class="oa-signin-ring" fill-rule="evenodd">${paths(OA_MARK.rings)}</g><g class="oa-signin-stem">${paths(OA_MARK.stems)}</g></svg>`;
}
/** `<OaSignInButton>`'s markup as a string. Put `OA_SIGNIN_CSS` in the page's styles. */
export function oaSignInHtml({ href, variant = 'taupe', label, account, className }) {
    const open = `<a class="${esc(oaSignInClasses(variant, !!account, className))}" href="${esc(href)}">`;
    const logo = `<span class="oa-signin-logo">${oaMarkSvg()}</span>`;
    if (account) {
        const first = firstName(account);
        const avatar = account.avatar
            ? `<img class="oa-signin-avatar" src="${esc(account.avatar)}" alt="" referrerpolicy="no-referrer">`
            : `<span class="oa-signin-avatar" aria-hidden="true">${esc((first ?? account.email).charAt(0).toUpperCase())}</span>`;
        const email = first ? `<span class="oa-signin-email">${esc(account.email)}</span>` : '';
        return `${open}${avatar}<span class="oa-signin-who"><span class="oa-signin-name">Continue as ${esc(first ?? account.email)}</span>${email}</span>${logo}</a>`;
    }
    return `${open}${logo}<span class="oa-signin-label">${esc(label ?? 'Sign in with OA')}</span><span class="oa-signin-spacer" aria-hidden="true"></span></a>`;
}
/**
 * The button's styles (also in `/react/ui.css`). Each variant is variables, so a host (or another org's brand) restyles
 * it by setting them on `.oa-signin` or `.oa-signin-<variant>`.
 */
export const OA_SIGNIN_CSS = `:where(.oa-signin) {
  --oa-signin-bg: #a99b8d;
  --oa-signin-ink: #1f1e1b;
  --oa-signin-line: var(--oa-signin-bg);
  --oa-signin-ring: currentColor;
  --oa-signin-stem: currentColor;
  --oa-signin-tile: transparent;
  --oa-signin-radius: 4px;
}
:where(.oa-signin-neutral) {
  --oa-signin-bg: light-dark(#fff, #131314);
  --oa-signin-ink: light-dark(#1f1e1b, #e3e3e3);
  --oa-signin-line: light-dark(#747775, #8e918f);
  --oa-signin-ring: light-dark(#696751, #a99b8d);
  --oa-signin-stem: light-dark(#9c683c, #b57e4f);
}
:where(.oa-signin-blue) {
  --oa-signin-bg: #224a82;
  --oa-signin-ink: #fff;
  --oa-signin-ring: #696751;
  --oa-signin-stem: #9c683c;
  --oa-signin-tile: #fff;
}
.oa-signin {
  align-items: center;
  background: var(--oa-signin-bg);
  border: 1px solid var(--oa-signin-line);
  border-radius: var(--oa-signin-radius);
  box-sizing: border-box;
  color: var(--oa-signin-ink);
  display: flex;
  font-size: 14px;
  font-weight: 600;
  gap: 12px;
  min-height: 40px;
  padding: 0 12px;
  text-decoration: none;
  width: 100%;
}
.oa-signin:hover { filter: brightness(1.06); }
.oa-signin:focus-visible { outline: 2px solid var(--oa-signin-ink); outline-offset: 2px; }
.oa-signin-logo {
  align-items: center;
  background: var(--oa-signin-tile);
  border-radius: calc(var(--oa-signin-radius) - 1px);
  display: flex;
  flex: none;
  height: 22px;
  justify-content: center;
  width: 22px;
}
.oa-signin-blue .oa-signin-logo { height: 32px; margin-left: -8px; width: 32px; }
.oa-signin-blue:not(.oa-signin-account) .oa-signin-spacer { width: 24px; }
.oa-signin-blue.oa-signin-account .oa-signin-logo { margin: 0 -8px 0 0; }
.oa-signin-ring { fill: var(--oa-signin-ring); }
.oa-signin-stem { fill: var(--oa-signin-stem); }
.oa-signin-label { flex: 1; text-align: center; }
.oa-signin-spacer { flex: none; width: 22px; }
.oa-signin-account { padding: 4px 12px 4px 8px; }
.oa-signin-avatar {
  align-items: center;
  background: color-mix(in srgb, var(--oa-signin-ink) 18%, transparent);
  border-radius: 50%;
  display: flex;
  flex: none;
  font-size: 13px;
  height: 28px;
  justify-content: center;
  object-fit: cover;
  width: 28px;
}
.oa-signin-who { display: flex; flex: 1; flex-direction: column; line-height: 1.25; min-width: 0; text-align: left; }
.oa-signin-email { font-size: 12px; font-weight: 400; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
