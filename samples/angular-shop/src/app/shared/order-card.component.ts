import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

import { Order } from '../orders/order.service';

@Component({
  selector: 'app-order-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="card" (click)="open.emit(order.id)">
      <span class="title">#{{ order.id }} — {{ order.customerName }}</span>
      <span class="total">{{ order.total | currency }}</span>
      <button *ngIf="order.status === 'NEW'" (click)="cancelOrder($event)">Cancel</button>
    </div>
  `,
})
export class OrderCardComponent {
  @Input({ required: true }) order!: Order;
  @Output() open = new EventEmitter<number>();
  @Output() cancelled = new EventEmitter<number>();

  cancelOrder(event: Event): void {
    event.stopPropagation();
    this.cancelled.emit(this.order.id);
  }
}
