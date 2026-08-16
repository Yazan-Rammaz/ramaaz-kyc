/**
 * FlexibleSpace — adaptive vertical spacer.
 *
 * Reads --xd-flex-deficit set by AppScaler (from scale.config.ts constants).
 *
 * Fixed mode (default):
 *   height = size − share × --xd-flex-deficit
 *   All share values on a page should sum to 1.
 *
 * Grow mode:
 *   flex: 1 — fills remaining space.
 */
export default function FlexibleSpace({
    size = 0,
    share = 0,
    grow = false,
}: {
    size?: number;
    share?: number;
    grow?: boolean;
}) {
    if (grow) {
        return (
            <div
                aria-hidden="true"
                style={{ flex: 1, minHeight: 0, width: '100%' }}
            />
        );
    }

    return (
        <div
            aria-hidden="true"
            style={{
                height: `calc(${size}px - ${share} * var(--xd-flex-deficit, 0px))`,
                flexShrink: 0,
                minHeight: 0,
            }}
        />
    );
}
