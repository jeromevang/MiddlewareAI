/**
 * PresetSelector Component
 * Quality preset cards (High, Medium, Low)
 */

import { Check } from 'lucide-react';
import type { QualityPreset } from '../../../lib/api';

interface PresetSelectorProps {
  presets: Record<string, QualityPreset>;
  quality: 'high' | 'medium' | 'low';
  onPresetChange: (preset: 'high' | 'medium' | 'low') => void;
  isModelAvailable: (modelId: string) => boolean;
  isLoading?: boolean;
}

// Utility function to get selected preset button classes
function getSelectedButtonClasses(color: string): string {
  const colorMap: Record<string, string> = {
    cyan: 'border-cyan-500/50 bg-cyan-500/10',
    purple: 'border-purple-500/50 bg-purple-500/10',
    green: 'border-green-500/50 bg-green-500/10',
  };
  return colorMap[color] || colorMap.cyan;
}

const presetMeta = {
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
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {Object.entries(presetMeta).map(([key, meta]) => {
          const preset = presets[key];
          const isSelected = quality === key;
          const availableCount = countAvailableModels(preset);
          
          return (
            <button
              key={key}
              className={`p-4 rounded-lg border text-left transition-all ${
                isSelected
                  ? getSelectedButtonClasses(meta.color)
                  : 'border-white/15 bg-white/5 hover:border-white/30'
              }`}
              onClick={() => onPresetChange(key as 'high' | 'medium' | 'low')}
              disabled={isLoading}
            >
              <h3 className="font-semibold text-white mb-1">{preset?.name || meta.label}</h3>
              <p className="text-xs text-white/60 mb-2">
                {preset?.description || meta.description}
              </p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/50">
                  {isLoading ? 'Loading...' : `${availableCount} main models available`}
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
