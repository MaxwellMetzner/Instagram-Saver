export const MENU_ID_PAGE = "save-instagram-page-media";
export const MENU_ID_CURRENT = "save-instagram-current-item";

export const CONTEXT_MENUS = Object.freeze([
  { id: MENU_ID_PAGE, title: "Download everything on this page", scope: "all" },
  { id: MENU_ID_CURRENT, title: "Download only the item on screen", scope: "current" }
]);

export function getMenuScope(menuItemId) {
  return CONTEXT_MENUS.find((menu) => menu.id === menuItemId)?.scope || null;
}
