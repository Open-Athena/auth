export const activityEndpoint = (endpoint) => endpoint.replace(/\/$/, '');
export async function activityJson(url, init) {
    const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' });
    let body;
    try {
        body = await response.json();
    }
    catch {
        throw new Error(`Activity request failed (HTTP ${response.status}): invalid response`);
    }
    if (!response.ok) {
        const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
        throw new Error(typeof error === 'string' ? error : `Activity request failed (HTTP ${response.status})`);
    }
    return body;
}
export const activityKeys = (endpoint) => ['oa-activity', activityEndpoint(endpoint)];
