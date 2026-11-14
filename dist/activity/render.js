/** Both supplied sinks use bounded plain text; only notify=line events disclose detail. */
export function activityMessage(burst, max) {
    const counts = Object.entries(burst.notifyCounts).map(([kind, n]) => `${kind}: ${n}`).join(', ');
    const lines = [
        `${burst.actor.name} (${burst.actor.via})`,
        `${new Date(burst.firstTs * 1000).toISOString()} - ${new Date(burst.lastTs * 1000).toISOString()}`,
        counts,
    ];
    for (const event of burst.lines) {
        if (event.notify !== 'line')
            continue;
        lines.push(`[${event.kind}] ${event.line ?? event.path ?? event.kind}`);
    }
    if (burst.omittedLines)
        lines.push(`Earlier recorded lines omitted: ${burst.omittedLines}`);
    const text = lines.join('\n');
    return text.length <= max ? text : `${text.slice(0, max - 14)}\n[truncated]`;
}
