let _limitAmount = 300;

export function getLimitAmount(): number {
  return _limitAmount;
}

export function setLimitAmount(amount: number): void {
  _limitAmount = amount;
}
