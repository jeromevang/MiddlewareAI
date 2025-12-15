/**
 * PresetSelector Component
 * Quality preset cards (High, Medium, Low)
 */

import { Check } from 'lucide-react';
import type { QualityPreset } from '../../../lib/api';

export type PresetQuality = 'high' | 'medium' | 'low' | 'custom';

interface PresetSelectorProps {
  presets: Record<string, QualityPreset>;
  quality: PresetQuality;
  onPresetChange: (preset: PresetQuality) => void;
  isModelAvailable: (modelId: string) => boolean;
  isLoading?: boolean;
}

// Utility function to get selected preset button classes
function getSelectedButtonClasses(color: string): string {
  const colorMap: Record<string, string> = {
    cyan: 'border-cyan-500/50 bg-cyan-500/10',
    purple: 'border-purple-500/50 bg-purple-500/10',
    green: 'border-green-500/50 bg-green-500/10',
    amber: 'border-amber-500/50 bg-amber-500/10',
  };
  return colorMap[color] || colorMap.cyan;
}

const presetMeta: Record<PresetQuality, { label: string; description: string; color: string; isCustom?: boolean }> = {
  high: {
    label: 'High Quality',
    description: 'Best quality for 12GB+ VRAM',
    color: 'cyan'
  },
  medium: {
    label: 'Balanced',
    description: 'Good balance for 8GB VRAM',
    color: 'purple'
  },
  low: {
    label: 'Fast & Lightweight',
    description: 'Works on 4GB VRAM, fastest inference',
    color: 'green'
  },
  custom: {
    label: 'Custom',
    description: 'Manual model selection',
    color: 'amber',
    isCustom: true
  },
};

export function PresetSelector({
  presets,
  quality,
  onPresetChange,
  isModelAvailable,
  isLoading = false,
}: PresetSelectorProps) {
  const countAvailableModels = (preset: QualityPreset): number => {
    if (!preset?.mainOptions) return 0;
    return preset.mainOptions.filter(id => isModelAvailable(id)).length;
  };

  return (
    <div className="mb-6">
      <p className="text-sm text-white/60 mb-3">
        Select a preset to automatically configure optimal models
      </p>
      
      <h3 className="text-sm font-semibold text-white/70 mb-3">Quality Presets</h3>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(presetMeta).map(([key, meta]) => {
          const preset = presets[key];
          const isSelected = quality === key;
          const availableCount = meta.isCustom ? 0 : countAvailableModels(preset);
          
          return (
            <button
              key={key}
              className={`p-4 rounded-lg border text-left transition-all ${
                isSelected
                  ? getSelectedButtonClasses(meta.color)
                  : 'border-white/15 bg-white/5 hover:border-white/30'
              }`}
              onClick={() => onPresetChange(key as PresetQuality)}
              disabled={isLoading}
            >
              <h3 className="font-semibold text-white mb-1">{preset?.name || meta.label}</h3>
              <p className="text-xs text-white/60 mb-2">
                {preset?.description || meta.description}
              </p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/50">
                  {isLoading ? 'Loading...' : meta.isCustom ? 'Configure below' : `${availableCount} models`}
                </span>
                {isSelected && (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <Check className="w-3 h-3" />
                    Selected
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default PresetSelector;
