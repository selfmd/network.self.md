import { Dithering } from "@paper-design/shaders-react";

const layerStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
};

export function ShaderBackground() {
  return (
    <div className="shader-bg">
      <div className="shader-layer" style={{ opacity: 0.8 }}>
        <Dithering
          colorBack="#0b0d10"
          colorFront="#41e98d"
          shape="wave"
          type="4x4"
          size={3}
          speed={0.1}
          scale={2.2}
          rotation={10}
          offsetX={-0.4}
          offsetY={0.45}
          style={layerStyle}
        />
      </div>
      <div className="shader-layer shader-blend" style={{ opacity: 0.5 }}>
        <Dithering
          colorBack="#000000"
          colorFront="#b4a0ff"
          shape="sphere"
          type="4x4"
          size={3}
          speed={0.06}
          scale={1.2}
          offsetX={0.5}
          offsetY={-0.45}
          style={layerStyle}
        />
      </div>
      <div className="shader-layer shader-blend" style={{ opacity: 0.45 }}>
        <Dithering
          colorBack="#000000"
          colorFront="#00bcd4"
          shape="wave"
          type="4x4"
          size={3}
          speed={0.08}
          scale={2}
          rotation={-15}
          offsetX={0.35}
          offsetY={0.4}
          style={layerStyle}
        />
      </div>
    </div>
  );
}
