import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../environments/environment';

export interface OrderItem {
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  id: number;
  placedAt: string;
  total: number;
  status: string;
  customerName: string;
  items: OrderItem[];
}

export interface CreateOrderRequest {
  customerId: number;
  items: OrderItem[];
}

@Injectable({ providedIn: 'root' })
export class OrderService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  list(): Observable<Order[]> {
    return this.http.get<Order[]>(`${this.base}/api/orders`);
  }

  byId(id: number): Observable<Order> {
    return this.http.get<Order>(`${this.base}/api/orders/${id}`);
  }

  create(request: CreateOrderRequest): Observable<Order> {
    return this.http.post<Order>(`${this.base}/api/orders`, request);
  }

  cancel(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/orders/${id}`);
  }
}
