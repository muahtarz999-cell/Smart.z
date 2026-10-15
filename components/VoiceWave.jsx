'use client';

/**
 * The orb's compact form during a conversation: one vibrating line.
 *   listening    → follows the real microphone level
 *   speaking     → lively synthetic wave
 *   thinking / transcribing / preparing → slow breathing pulse
 *   otherwise    → nearly flat
 * Drawn on a canvas at the display's pixel ratio; levelRef.current (0..1) is
 * written by the recorder without re-rendering React.
 */

import { useEffect, useRef } from 'react';

const GOLD = '#C9A868';
const GOLD_LIGHT = '#F0D48A';

export default function VoiceWave({ state, levelRef, height = 56 }) {
  const canvasRef = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    let frame;
    let amplitude = 0;
    let phase = 0;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * ratio;
      canvas.height = canvas.clientHeight * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = (time) => {
      const width = canvas.clientWidth;
      const h = canvas.clientHeight;
      const mid = h / 2;
      const current = stateRef.current;

      let target;
      let speed;
      if (current === 'listening') {
        target = 0.15 + Math.min(1, (levelRef?.current || 0) * 1.6) * 0.85;
        speed = 0.12;
      } else if (current === 'speaking') {
        target = 0.55 + 0.3 * Math.sin(time / 180) * Math.sin(time / 470);
        speed = 0.1;
      } else if (current === 'thinking' || current === 'transcribing' || current === 'preparing') {
        target = 0.18 + 0.12 * Math.sin(time / 420);
        speed = 0.05;
      } else {
        target = 0.04;
        speed = 0.03;
      }
      amplitude += (target - amplitude) * 0.15; // smooth so the line never jumps
      phase += speed;

      context.clearRect(0, 0, width, h);
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, 'rgba(201,168,104,0)');
      gradient.addColorStop(0.2, GOLD);
      gradient.addColorStop(0.5, GOLD_LIGHT);
      gradient.addColorStop(0.8, GOLD);
      gradient.addColorStop(1, 'rgba(201,168,104,0)');

      // Three layered sine waves: the main line plus two fainter echoes.
      [[1, 2.2, 1], [0.6, 3.1, 0.45], [0.35, 1.4, 0.25]].forEach(([scale, frequency, alpha], layer) => {
        context.beginPath();
        for (let x = 0; x <= width; x += 2) {
          const t = x / width;
          const envelope = Math.sin(Math.PI * t); // pinned at both ends
          const y = mid + Math.sin(t * Math.PI * 2 * frequency + phase * (layer + 1)) * envelope * amplitude * scale * (h * 0.42);
          if (x === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.strokeStyle = gradient;
        context.globalAlpha = alpha;
        context.lineWidth = layer === 0 ? 2.2 : 1.2;
        context.stroke();
      });
      context.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, [levelRef]);

  return <canvas ref={canvasRef} aria-hidden="true" className="block w-full max-w-full" style={{ height }} />;
}
