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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { to, message, from } = body;

    if (!to || !message) {
      return NextResponse.json({ error: 'Missing required fields: to, message' }, { status: 400 });
    }

    const client = getATClient();
    
    // The format required by Africa's Talking SMS
    const options: any = {
      to,
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
