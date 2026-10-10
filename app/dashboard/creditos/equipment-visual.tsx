"use client";

import { useState } from "react";
import Image from "next/image";
import { Smartphone } from "lucide-react";
import styles from "./equipment-signature.module.css";

export default function EquipmentVisual({ reference, platform, imageUrl, className = "" }: {
  reference: string;
  platform: "iphone" | "android" | null;
  imageUrl?: string | null;
  className?: string;
}) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const availableImage = imageUrl?.trim();
  const showModelImage = Boolean(availableImage && availableImage !== failedImageUrl);
  const isIphone = /^iphone/i.test(reference.trim()) || platform === "iphone";
  const platformImage = isIphone
    ? "/assets/dashboard/apple.svg"
    : platform === "android"
      ? "/assets/dashboard/android.svg"
      : null;

  return (
    <span className={`${styles.equipmentVisual} ${className}`} aria-hidden="true" data-model-image={showModelImage}>
      {showModelImage ? (
        <Image
          src={availableImage!}
          width={96}
          height={96}
          alt=""
          unoptimized
          onError={() => setFailedImageUrl(availableImage!)}
        />
      ) : platformImage ? (
        <Image src={platformImage} width={44} height={44} alt="" />
      ) : (
        <Smartphone strokeWidth={1.8} />
      )}
    </span>
  );
}
