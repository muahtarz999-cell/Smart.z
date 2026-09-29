'use client';

import { useEffect, useRef } from 'react';

const GOLD_SHADES = ['#F0D48A', '#D9AE55', '#C9A868', '#B8863A', '#8A6E3E'];
const PETROL_SHADES = ['#3E5C66', '#2E5C55', '#4A7A78'];

export default function AssistantOrb({ size = 128, listening = true }) {
  const gridRef = useRef(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    grid.innerHTML = '';

    const cols = 16;
    const rows = 16;
    const cx = 7.5;
    const cy = 7.5;
    const radius = 8.0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dx = c - cx;
        const dy = r - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const tile = document.createElement('div');

        if (dist > radius) {
          tile.style.visibility = 'hidden';
          grid.appendChild(tile);
          continue;
        }

        const isPetrol = (r * 3 + c * 5) % 11 === 0;
        const palette = isPetrol ? PETROL_SHADES : GOLD_SHADES;
        const color = palette[(r * cols + c) % palette.length];

        tile.className = 'wave-tile';
        tile.style.background = color;
        tile.style.borderRadius = '1px';
        tile.style.animationDuration = '4.2s';
        tile.style.animationDelay = `${dist * 0.22}s`;
        if (!listening) {
          tile.style.animationPlayState = 'paused';
          tile.style.opacity = '0.5';
        }
        grid.appendChild(tile);
      }
    }
  }, [listening]);

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        overflow: 'hidden',
        background: '#12151C',
        boxShadow: '0 0 30px 4px rgba(201,168,104,0.3)',
        transition: 'width 0.35s ease, height 0.35s ease',
      }}
    >
      <div
        ref={gridRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          gridTemplateColumns: 'repeat(16, 1fr)',
          gridTemplateRows: 'repeat(16, 1fr)',
          gap: '1px',
          padding: '2px',
        }}
      />
    </div>
  );
}
