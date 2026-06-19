import type { CreateProductDto } from '../products/dto/create-product.dto';
import type { CreateFarmerDto } from '../farmers/dto/create-farmer.dto';
import type { CreateSubcategoryDto } from '../subcategories/dto/create-subcategory.dto';
import type { PlatformImportDto } from './dto/platform-import.dto';

/**
 * Fixed sample catalog seeded into every demo tenant so the farmer panel looks
 * alive the moment a friend logs in. Products use a plain `category` text label
 * and the virtual `stock` field (opens an open-ended availability window); they
 * are not wired to farmer/subcategory IDs, so multiFarmer/multiSubcat stay off.
 */
export const DEMO_SEED: PlatformImportDto & {
  categories: CreateSubcategoryDto[];
  farmers: CreateFarmerDto[];
  products: CreateProductDto[];
} = {
  categories: [
    { name: 'Зеленчуци', tint: '#4C8A54' },
    { name: 'Плодове', tint: '#D94A4A' },
    { name: 'Млечни', tint: '#E0A93B' },
  ],
  farmers: [
    { name: 'Иван Петров', role: 'Зеленчукопроизводител', since: '2015', tint: '#2C5530' },
    { name: 'Мария Колева', role: 'Пчелар и млечни', since: '2012', tint: '#E0A93B' },
  ],
  products: [
    { name: 'Домати „Биволско сърце"', category: 'Зеленчуци', priceStotinki: 450, unit: 'kg', stock: 40, tint: '#D94A4A' },
    { name: 'Краставици', category: 'Зеленчуци', priceStotinki: 320, unit: 'kg', stock: 30, tint: '#4C8A54' },
    { name: 'Картофи', category: 'Зеленчуци', priceStotinki: 180, unit: 'kg', stock: 100, tint: '#B98A3B' },
    { name: 'Ябълки „Флорина"', category: 'Плодове', priceStotinki: 280, unit: 'kg', stock: 60, tint: '#D94A4A' },
    { name: 'Круши', category: 'Плодове', priceStotinki: 350, unit: 'kg', stock: 25, tint: '#9BBF45' },
    { name: 'Ягоди', category: 'Плодове', priceStotinki: 600, unit: 'кутия', stock: 15, tint: '#D94A4A' },
    { name: 'Прясно мляко', category: 'Млечни', priceStotinki: 250, unit: 'литър', stock: 20, tint: '#E0A93B' },
    { name: 'Бяло саламурено сирене', category: 'Млечни', priceStotinki: 1400, unit: 'kg', stock: 12, tint: '#E0A93B' },
  ],
};
