export const PURCHASE_WEBHOOK_UPDATE_SQL = `UPDATE founding_purchases SET dodo_payment_id=?,dodo_customer_id=COALESCE(?,dodo_customer_id),
  customer_email=COALESCE(?,customer_email),status=CASE
    WHEN status='refunded' OR ? IS NULL OR (status LIKE 'dispute_%' AND ? NOT LIKE 'dispute_%') THEN status ELSE ? END,
  amount=COALESCE(?,amount),currency=COALESCE(?,currency),paid_at=COALESCE(paid_at,?),
  activation_deadline_at=COALESCE(activation_deadline_at,?),refund_id=COALESCE(?,refund_id),
  refund_status=CASE WHEN refund_status='succeeded' OR ? IS NULL THEN refund_status ELSE ? END,updated_at=CURRENT_TIMESTAMP
  WHERE product_id=? AND ((? IS NOT NULL AND id=?) OR dodo_payment_id=?)`;
