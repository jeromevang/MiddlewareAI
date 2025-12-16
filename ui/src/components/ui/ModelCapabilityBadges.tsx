import clsx from "clsx";

// Role badge definitions with colors
export const ROLE_BADGES = {
  agentic: { 
    icon: '🤖', 
    label: 'Agentic', 
    bg: 'bg-emerald-500/20', 
    border: 'border-emerald-500/40',
    text: 'text-emerald-400',
    description: 'Full tool calling support' 
  },
  toolUse: { 
    icon: '🔧', 
    label: 'Tool Use', 
    bg: 'bg-blue-500/20', 
    border: 'border-blue-500/40',
    text: 'text-blue-400',
    description: 'Has tool calling' 
  },
  chat: { 
    icon: '💬', 
    label: 'Chat', 
    bg: 'bg-gray-500/20', 
    border: 'border-gray-500/40',
    text: 'text-gray-400',
    description: 'Chat only' 
  },
  summarizer: { 
    icon: '📊', 
    label: 'Summarizer', 
    bg: 'bg-purple-500/20', 
    border: 'border-purple-500/40',
    text: 'text-purple-400',
    description: 'For summarization' 
  },
  embedder: { 
    icon: '🧮', 
    label: 'Embedder', 
    bg: 'bg-orange-500/20', 
    border: 'border-orange-500/40',
    text: 'text-orange-400',
    description: 'Embedding only' 
  },
} as const;

// Quantization quality badges
export const QUANT_BADGES = {
  excellent: { label: 'Q8', bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
  very_good: { label: 'Q6', bg: 'bg-green-500/20', text: 'text-green-400' },
  good: { label: 'Q5', bg: 'bg-lime-500/20', text: 'text-lime-400' },
  acceptable: { label: 'Q4', bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
  degraded: { label: 'Q3', bg: 'bg-orange-500/20', text: 'text-orange-400' },
  poor: { label: 'Q2', bg: 'bg-red-500/20', text: 'text-red-400' },
  very_poor: { label: 'Q1', bg: 'bg-red-600/20', text: 'text-red-500' },
} as const;

// Capability badges
export const CAPABILITY_BADGES = {
  vision: { icon: '👁️', label: 'Vision', bg: 'bg-cyan-500/20', text: 'text-cyan-400' },
  longContext: { icon: '📜', label: '32K+', bg: 'bg-teal-500/20', text: 'text-teal-400' },
  fast: { icon: '⚡', label: 'Fast', bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
} as const;

interface ModelCapabilityBadgesProps {
  model: {
    roleBadge?: string;
    agenticScore?: number;
    agenticViable?: boolean;
    quantQuality?: string;
    quantLabel?: string;
    quantBits?: number;
    sizeGB?: number;
    maxContextLength?: number;
    vision?: boolean;
    capabilities?: string[];
    reliableForTools?: boolean;
  };
  showSize?: boolean;
  showContext?: boolean;
  showScore?: boolean;
  compact?: boolean;
  className?: string;
}

export function ModelCapabilityBadges({ 
  model, 
  showSize = true, 
  showContext = true,
  showScore = false,
  compact = false,
  className 
}: ModelCapabilityBadgesProps) {
  const roleBadge = ROLE_BADGES[model.roleBadge as keyof typeof ROLE_BADGES] || ROLE_BADGES.chat;
  const quantBadge = QUANT_BADGES[model.quantQuality as keyof typeof QUANT_BADGES] || QUANT_BADGES.acceptable;
  
  const badgeClasses = compact 
    ? "px-1.5 py-0.5 text-[10px]" 
    : "px-2 py-0.5 text-xs";

  return (
    <div className={clsx("flex flex-wrap items-center gap-1.5", className)}>
      {/* Role Badge - Primary */}
      <span 
        className={clsx(
          "inline-flex items-center rounded-full font-medium border",
          roleBadge.bg, roleBadge.border, roleBadge.text,
          badgeClasses
        )}
        title={roleBadge.description}
      >
        <span className="mr-1">{roleBadge.icon}</span>
        {roleBadge.label}
      </span>

      {/* Quantization Badge */}
      <span 
        className={clsx(
          "inline-flex items-center rounded-full font-medium border border-white/20",
          quantBadge.bg, quantBadge.text,
          badgeClasses
        )}
        title={`Quantization: ${model.quantBits || 4}-bit`}
      >
        {model.quantLabel || quantBadge.label}
      </span>

      {/* Size Badge */}
      {showSize && model.sizeGB !== undefined && (
        <span 
          className={clsx(
            "inline-flex items-center rounded-full font-medium bg-white/10 text-white/70 border border-white/20",
            badgeClasses
          )}
        >
          {model.sizeGB.toFixed(1)} GB
        </span>
      )}

      {/* Context Badge */}
      {showContext && model.maxContextLength && model.maxContextLength >= 16384 && (
        <span 
          className={clsx(
            "inline-flex items-center rounded-full font-medium",
            CAPABILITY_BADGES.longContext.bg, CAPABILITY_BADGES.longContext.text,
            "border border-white/20",
            badgeClasses
          )}
          title={`${(model.maxContextLength / 1024).toFixed(0)}K context window`}
        >
          {CAPABILITY_BADGES.longContext.icon} {(model.maxContextLength / 1024).toFixed(0)}K
        </span>
      )}

      {/* Vision Badge */}
      {model.vision && (
        <span 
          className={clsx(
            "inline-flex items-center rounded-full font-medium",
            CAPABILITY_BADGES.vision.bg, CAPABILITY_BADGES.vision.text,
            "border border-white/20",
            badgeClasses
          )}
          title="Can process images"
        >
          {CAPABILITY_BADGES.vision.icon}
        </span>
      )}

      {/* Agentic Score */}
      {showScore && model.agenticScore !== undefined && (
        <span 
          className={clsx(
            "inline-flex items-center rounded-full font-medium border border-white/20",
            model.agenticScore >= 70 ? "bg-emerald-500/20 text-emerald-400" :
            model.agenticScore >= 50 ? "bg-yellow-500/20 text-yellow-400" :
            "bg-red-500/20 text-red-400",
            badgeClasses
          )}
          title={`Agentic score: ${model.agenticScore}/100`}
        >
          {model.agenticScore}
        </span>
      )}

      {/* Warning for unreliable tools */}
      {model.reliableForTools === false && (
        <span 
          className={clsx(
            "inline-flex items-center rounded-full font-medium bg-red-500/20 text-red-400 border border-red-500/40",
            badgeClasses
          )}
          title="Low quantization - unreliable for tool calling"
        >
          ⚠️
        </span>
      )}
    </div>
  );
}

// Compact single badge for inline use
interface RoleBadgeProps {
  role: string;
  compact?: boolean;
  className?: string;
}

export function RoleBadge({ role, compact = false, className }: RoleBadgeProps) {
  const badge = ROLE_BADGES[role as keyof typeof ROLE_BADGES] || ROLE_BADGES.chat;
  
  return (
    <span 
      className={clsx(
        "inline-flex items-center rounded-full font-medium border",
        badge.bg, badge.border, badge.text,
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs",
        className
      )}
      title={badge.description}
    >
      <span className="mr-1">{badge.icon}</span>
      {badge.label}
    </span>
  );
}

// Warning banner for non-agentic models
interface AgenticWarningProps {
  reason?: string;
  className?: string;
}

export function AgenticWarning({ reason, className }: AgenticWarningProps) {
  return (
    <div className={clsx(
      "flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm",
      className
    )}>
      <span>⚠️</span>
      <span>{reason || 'This model may not work well for agentic/tool-calling tasks'}</span>
    </div>
  );
}

