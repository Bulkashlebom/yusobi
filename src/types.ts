export interface SystemStatus {
  bot: {
    hasToken: boolean;
    tokenMasked: string;
    adminId: string;
    paymentDetails: string;
    supportContact: string;
  };
  database: {
    totalOrders: number;
    totalRevenue: number;
    approvedCount: number;
    pendingOrders: number;
    refundedOrders?: number;
    availableProducts: number;
    soldProducts: number;
  };
}

export interface Order {
  id: number;
  user_id: number;
  username: string;
  product_id: number;
  product_name?: string;
  amount: number;
  base_amount?: number;
  fee_amount?: number;
  fee_percent?: number;
  fee_type?: 'PERCENT' | 'FIXED';
  fee_value?: number;
  quantity?: number;
  buyer_comment?: string;
  seller_comment?: string;
  receipt_file_id?: string;
  receipt_unique_id?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'REFUNDED';
  is_reserved?: number;
  delivered_keys?: string;
  delivery_type?: 'AUTO' | 'MANUAL';
  product_delivery_type?: 'AUTO' | 'MANUAL';
  product_secret_data?: string;
  product_type?: 'FIXED' | 'FLEXIBLE';
  created_at: string;
}

export interface CustomProduct {
  id: number;
  name: string;
  description: string;
  price: number;
  delivery_type: 'AUTO' | 'MANUAL';
  secret_data?: string;
  stock: number;
  reserved_stock?: number;
  is_unlimited: number;
  is_hidden?: number;
  is_sold: number;
  product_type: 'FIXED' | 'FLEXIBLE';
  min_amount: number;
  max_amount: number;
  fee_type: 'PERCENT' | 'FIXED';
  fee_value: number;
  allow_decimals: number;
  fee_percent?: number;
  fee_fixed?: number;
  created_at: string;
}

export interface BotSimulateResponse {
  type: 'text' | 'order_created' | 'receipt_uploaded' | 'comment_prompt' | 'product_card';
  text: string;
  keyboard?: { label: string; action: string; payload?: any }[][];
  order?: Order;
  product?: CustomProduct;
  products?: CustomProduct[];
}

export interface BlacklistItem {
  user_id: number;
  reason?: string;
  created_at: string;
}
