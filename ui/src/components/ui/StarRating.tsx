import clsx from "clsx";

interface StarRatingProps {
  stars: number;
  maxStars?: number;
  label?: string;
  showLabel?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeStyles = {
  sm: "w-3 h-3",
  md: "w-4 h-4",
  lg: "w-5 h-5",
};

const labelSizeStyles = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

/**
 * Star rating component for displaying model quality/resource intensity
 * 
 * Stars indicate resource usage:
 * - 1 star: Lightweight (<1GB)
 * - 2 stars: Fast (1-3GB)
 * - 3 stars: Balanced (3-6GB)
 * - 4 stars: Quality (6-10GB)
 * - 5 stars: Premium (10GB+)
 */
export function StarRating({
  stars,
  maxStars = 5,
  label,
  showLabel = false,
  size = "md",
  className,
}: StarRatingProps) {
  const filledStars = Math.min(Math.max(0, Math.round(stars)), maxStars);
  const emptyStars = maxStars - filledStars;

  return (
    <div className={clsx("flex items-center gap-1.5", className)}>
      <div className="flex items-center gap-0.5">
        {/* Filled stars */}
        {Array.from({ length: filledStars }).map((_, i) => (
          <Star key={`filled-${i}`} filled size={size} />
        ))}
        {/* Empty stars */}
        {Array.from({ length: emptyStars }).map((_, i) => (
          <Star key={`empty-${i}`} filled={false} size={size} />
        ))}
      </div>
      {showLabel && label && (
        <span className={clsx("text-white/60", labelSizeStyles[size])}>
          {label}
        </span>
      )}
    </div>
  );
}

interface StarProps {
  filled: boolean;
  size: "sm" | "md" | "lg";
}

function Star({ filled, size }: StarProps) {
  return (
    <svg
      className={clsx(
        sizeStyles[size],
        filled ? "text-amber-400" : "text-white/20"
      )}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.5}
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"
      />
    </svg>
  );
}

/**
 * Get star rating info from model size in GB
 */
export function getStarRatingFromSize(sizeGB: number): {
  stars: number;
  label: string;
} {
  if (!sizeGB || sizeGB <= 0) {
    return { stars: 0, label: "Unknown" };
  }

  if (sizeGB < 1) {
    return { stars: 1, label: "Lightweight" };
  } else if (sizeGB < 3) {
    return { stars: 2, label: "Fast" };
  } else if (sizeGB < 6) {
    return { stars: 3, label: "Balanced" };
  } else if (sizeGB < 10) {
    return { stars: 4, label: "Quality" };
  } else {
    return { stars: 5, label: "Premium" };
  }
}

