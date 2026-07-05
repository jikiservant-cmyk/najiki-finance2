import { NextRequest, NextResponse } from 'next/server';
import africastalking from 'africastalking';

let atClient: any = null;

function getATClient() {
  if (!atClient) {
    const apiKey = process.env.AFRICASTALKING_API_KEY;
    const username = process.env.AFRICASTALKING_USERNAME || 'sandbox'; // Default to sandbox if not provided, though production should override

    if (!apiKey) {
      throw new Error('AFRICASTALKING_API_KEY environment variable is required');
    }

    atClient = africastalking({
      apiKey,
      username,
    });
  }
  return atClient;
}

function formatPhoneNumber(phone: string): string {
  let cleaned = phone.trim();
  
  // Remove all characters except digits and '+'
  cleaned = cleaned.replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+')) {
    return cleaned;
  }

  // If it starts with '0', replace with default country code '+256' (Uganda, corresponding to the dashboard's currency of UGX)
  if (cleaned.startsWith('0')) {
    return '+256' + cleaned.substring(1);
  }

  // If it already starts with an East African country code without '+'
  if (cleaned.startsWith('256') || cleaned.startsWith('254') || cleaned.startsWith('255')) {
    return '+' + cleaned;
  }

  // Default fallback if it's a 9-digit local number (e.g. 770123456), prepend '+256'
  if (cleaned.length === 9) {
    return '+256' + cleaned;
  }

  // If we don't know but it doesn't start with '+', prepend '+'
  return '+' + cleaned;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { to, message, from } = body;

    if (!to || !message) {
      return NextResponse.json({ error: 'Missing required fields: to, message' }, { status: 400 });
    }

    // Split by comma in case of multiple recipients, format each, and filter out empties
    const formattedTo = to
      .split(',')
      .map((num: string) => formatPhoneNumber(num))
      .filter((num: string) => num.length > 1)
      .join(',');

    if (!formattedTo) {
      return NextResponse.json({ error: 'Invalid recipient phone number(s)' }, { status: 400 });
    }

    const client = getATClient();
    
    // The format required by Africa's Talking SMS
    const options: any = {
      to: formattedTo,
      message,
    };
    
    // Only add 'from' if it's provided, otherwise uses the default sender ID or shortcode registered with the account
    if (from) {
      options.from = from;
    }

    const response = await client.SMS.send(options);
    
    return NextResponse.json({ success: true, data: response });
  } catch (error: any) {
    console.error('Error sending SMS via Africas Talking:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to send SMS' },
      { status: 500 }
    );
  }
}
