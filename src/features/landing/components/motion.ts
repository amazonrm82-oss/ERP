// LND-20 v2: the landing page's one pause control (WCAG 2.2.2) reaches the parts that move on their own through this event;
// CSS animations stop through the page's data-paused attribute.
export const LANDING_MOTION_EVENT = "mx-landing-motion";
export const LANDING_ROOT_ID = "landing-root";

export type LandingMotionDetail = { paused: boolean };
