import React from "react";
import "./photography-watermark.css";

// Visual design simulation. Production proofs require server-rendered pixels.
export function Watermark({
  brand,
  enabled = true,
  variant = "proof",
  pattern,
}) {
  if (!enabled) return null;
  const type = brand.watermarkType || "text";
  const placement =
    pattern ||
    (variant === "proof" ? brand.watermarkPattern || "tile" : "signature");
  const mark = (
    <>
      {type !== "text" &&
        (brand.logoImage ? (
          <img className="phm-logo" src={brand.logoImage} alt="" />
        ) : (
          <span className="phm-monogram">{brand.logo || "CL"}</span>
        ))}
      {type !== "logo" && (
        <span className="phm-name">{brand.watermarkText || brand.name}</span>
      )}
      {variant === "proof" && (
        <small>{brand.watermarkSubline ?? "Proof • not retouched"}</small>
      )}
    </>
  );
  return (
    <span
      aria-hidden="true"
      className={
        "phm phm-" +
        placement +
        " at-" +
        (brand.watermarkPosition || "bottom-right")
      }
      style={{
        color: brand.watermarkColor || "#ffffff",
        opacity:
          (variant === "proof"
            ? (brand.watermarkOpacity ?? 45)
            : (brand.webWatermarkOpacity ?? brand.watermarkOpacity ?? 70)) /
          100,
        "--phm-font":
          brand.watermarkFont === "script"
            ? '"Great Vibes", cursive'
            : brand.watermarkFont === "sans"
              ? "system-ui, sans-serif"
              : "Georgia, serif",
        "--phm-size":
          (brand.watermarkSize || 6) * (variant === "web" ? 0.4 : 1) + "cqw",
        "--phm-angle": (brand.watermarkAngle ?? -24) + "deg",
        "--phm-gap": (brand.watermarkSpacing || 6) + "cqw",
      }}
    >
      {placement === "tile" ? (
        Array.from({ length: 9 }, (_, index) => (
          <span className="phm-mark" key={index}>
            {mark}
          </span>
        ))
      ) : (
        <span className="phm-mark">{mark}</span>
      )}
    </span>
  );
}
