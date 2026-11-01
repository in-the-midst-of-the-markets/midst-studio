"use client";

import { useEffect } from "react";
import { releaseEndedSubscriptions } from "@/lib/marketplace/release-subscription";

/** Drops a marketplace database once its Stripe subscription has ended, on every page. */
export function SubscriptionRelease() {
  useEffect(() => {
    void releaseEndedSubscriptions();
  }, []);
  return null;
}
