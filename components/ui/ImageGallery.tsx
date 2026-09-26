"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface GalleryImage {
  src: string;
  alt: string;
}

interface ImageGalleryProps {
  images: GalleryImage[];
  className?: string;
}

/**
 * Reusable image gallery with main image and thumbnail navigation.
 *
 * - Displays a main image with left/right navigation
 * - Shows smaller thumbnails below for quick selection
 * - Responsive layout: stacks on mobile
 */
export default function ImageGallery({ images, className = "" }: ImageGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  if (images.length === 0) return null;

  const selected = images[selectedIndex];

  const goNext = () => {
    setSelectedIndex((i) => (i + 1) % images.length);
  };

  const goPrev = () => {
    setSelectedIndex((i) => (i - 1 + images.length) % images.length);
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Main image */}
      <div className="relative aspect-video overflow-hidden rounded-2xl border border-vault-border bg-vault-surface">
        <AnimatePresence mode="wait">
          <motion.img
            key={selected.src}
            src={selected.src}
            alt={selected.alt}
            className="h-full w-full object-contain p-4"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
          />
        </AnimatePresence>

        {/* Navigation arrows */}
        {images.length > 1 && (
          <>
            <button
              onClick={goPrev}
              aria-label="Previous image"
              className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-vault-surface/80 p-2 text-vault-text shadow-lg backdrop-blur transition-colors hover:bg-vault-surface"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={goNext}
              aria-label="Next image"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-vault-surface/80 p-2 text-vault-text shadow-lg backdrop-blur transition-colors hover:bg-vault-surface"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}

        {/* Image counter */}
        <div className="absolute bottom-3 right-3 rounded-full bg-vault-bg/80 px-2.5 py-1 text-xs font-medium text-vault-muted backdrop-blur">
          {selectedIndex + 1} / {images.length}
        </div>
      </div>

      {/* Thumbnails */}
      {images.length > 1 && (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
          {images.map((img, i) => (
            <button
              key={i}
              onClick={() => setSelectedIndex(i)}
              className={`aspect-square overflow-hidden rounded-xl border-2 transition-all ${
                i === selectedIndex
                  ? "border-vault-accent shadow-glow"
                  : "border-vault-border opacity-60 hover:opacity-100"
              }`}
            >
              <img
                src={img.src}
                alt={img.alt}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
