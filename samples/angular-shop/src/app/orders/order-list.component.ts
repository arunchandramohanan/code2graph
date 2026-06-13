import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';

import { Order, OrderService } from './order.service';
import { OrderCardComponent } from '../shared/order-card.component';

@Component({
  selector: 'app-order-list',
  standalone: true,
  imports: [CommonModule, OrderCardComponent],
  templateUrl: './order-list.component.html',
})
export class OrderListComponent implements OnInit {
  private readonly orderService = inject(OrderService);
  private readonly router = inject(Router);

  orders: Order[] = [];
  loading = false;

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading = true;
    this.orderService.list().subscribe((orders) => {
      this.orders = orders;
      this.loading = false;
    });
  }

  openOrder(id: number): void {
    this.router.navigate(['/orders', id]);
  }

  cancelOrder(id: number): void {
    this.orderService.cancel(id).subscribe(() => this.refresh());
  }
}
