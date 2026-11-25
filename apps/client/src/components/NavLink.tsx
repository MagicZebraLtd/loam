import type { ComponentChildren } from "preact";
import { isPlainClick, useLocation } from "../lib/location";

interface NavLinkProps {
  active: boolean;
  /** Accessible name, required when the link's content is icon-only (e.g. the mobile back arrow). */
  ariaLabel?: string;
  children: ComponentChildren;
  className?: string;
  href: string;
}

/**
 * A client-side navigation anchor: renders a real `<a href>` (so it degrades and is inspectable) but
 * intercepts plain clicks to route through `lib/location` without a full page load (a modifier click is left
 * to the browser, which opens a tab or window). `href` is a route path
 * (`/dm/<id>`); the anchor points at its fragment form (`#/dm/<id>`), so "open in new tab" asks the node for
 * `/` only and the route stays off the wire. Marks itself
 * `aria-current="page"` when `active`, and takes an optional `className` override for non-nav uses
 * (e.g. the mobile back button).
 */
export function NavLink({ active, ariaLabel, children, className, href }: NavLinkProps) {
  const location = useLocation();
  const linkClassName = className ?? `nav-link${active ? " active" : ""}`;

  return (
    <a
      aria-current={active ? "page" : undefined}
      aria-label={ariaLabel}
      className={linkClassName}
      href={`#${href}`}
      onClick={(event) => {
        if (!isPlainClick(event)) {
          return;
        }
        event.preventDefault();
        location.route(href);
      }}
    >
      {children}
    </a>
  );
}
