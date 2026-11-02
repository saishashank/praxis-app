// Statistics library (M4 T12; design 4.8). Pure, deterministic, float64; money never passes through here.
export * from "./binomial";
export * from "./bootstrap";
export * from "./dsr";
export * from "./gates";
export * from "./ks";
export * from "./normal";
export * from "./pbo";
export * from "./rng";
// M15 C2 (Cortex statistics); rankIc, power and the other M14 modules stay imported by path.
export * from "./stationaryBootstrap";
export * from "./calibration";
export * from "./multiplicity";
export * from "./distinctness";
export * from "./nulls";
export * from "./cells";
export * from "./breakEven";
