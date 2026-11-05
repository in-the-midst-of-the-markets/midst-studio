"use client";

import { isCirclePack, type CirclePackCircle } from "@/lib/charts/circle-pack";

/**
 * SVG for a D3 circle pack. Coordinates are in a 100 by 100 square, so the
 * drawing scales with the card.
 */
export function CirclePackChart({ option }: { readonly option: Record<string, unknown> }) {
  if (!isCirclePack(option)) return null;
  const circles = option.data as CirclePackCircle[];
  const ink = typeof option.ink === "string" ? option.ink : "currentColor";
  return (
    <svg data-testid="circle-pack" aria-label="Circle packing" viewBox="0 0 100 100" className="h-full w-full">
      <title>Circle packing</title>
      {circles.map((circle) => (
        <g key={`${circle.depth}-${circle.name}-${circle.x}-${circle.y}-${circle.r}`}>
          <circle
            cx={circle.x}
            cy={circle.y}
            r={circle.r}
            fill={circle.color}
            fillOpacity={circle.leaf ? 0.9 : 0.25}
            stroke={circle.leaf ? "none" : circle.color}
          >
            <title>{`${circle.name}: ${circle.value}`}</title>
          </circle>
          {circle.leaf && circle.r >= 8 ? (
            <text
              x={circle.x}
              y={circle.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={Math.min(circle.r / 3, 6)}
              fill={ink}
            >
              {circle.name}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}
