// packages/help-content/src/categories.ts
import type { CategoryDef } from './types';

export const PANEL_CATEGORIES: CategoryDef[] = [
  { id: 'products', label: 'Продукти' },
  { id: 'orders', label: 'Поръчки' },
  { id: 'farmers', label: 'Фермери' },
  { id: 'categories', label: 'Категории' },
  { id: 'availability', label: 'Наличност' },
  { id: 'promotions', label: 'Промоции' },
  { id: 'delivery-slots', label: 'Доставка и часове' },
  { id: 'courier', label: 'Куриер' },
  { id: 'payments', label: 'Плащания' },
  { id: 'articles', label: 'Статии' },
  { id: 'reviews', label: 'Отзиви' },
  { id: 'site-editor', label: 'Сайт и редактор' },
  { id: 'marketing', label: 'Маркетинг' },
  { id: 'settings', label: 'Настройки' },
];

export const DELIVERY_CATEGORIES: CategoryDef[] = [
  { id: 'econt-speedy', label: 'Econt/Speedy връзка' },
  { id: 'import', label: 'Внос на пратки' },
  { id: 'handover', label: 'Предаване' },
  { id: 'cod', label: 'Проверка на клиент' },
  { id: 'tracking', label: 'Проследяване' },
];

export function categoriesFor(surface: 'panel' | 'delivery'): CategoryDef[] {
  return surface === 'delivery' ? DELIVERY_CATEGORIES : PANEL_CATEGORIES;
}
