import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../environments/environment';
import { Order } from '../orders/order.service';

export interface Customer {
  id: number;
  fullName: string;
  email: string;
  orderCount: number;
}

@Injectable({ providedIn: 'root' })
export class CustomerService {
  constructor(private http: HttpClient) {}

  list(): Observable<Customer[]> {
    return this.http.get<Customer[]>(environment.apiUrl + '/api/customers');
  }

  byId(id: number): Observable<Customer> {
    return this.http.get<Customer>(`${environment.apiUrl}/api/customers/${id}`);
  }

  ordersOf(id: number): Observable<Order[]> {
    return this.http.get<Order[]>(`${environment.apiUrl}/api/customers/${id}/orders`);
  }
}
